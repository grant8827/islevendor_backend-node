import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const authorizationRouter = Router();

const applySchema = z.object({
  warehouseId: z.string().uuid(),
});

// A reseller requests permission to list a warehouse's SKUs. Re-applying
// after a rejection resets the same row to PENDING rather than piling up
// duplicate requests (see the @@unique([storeId, warehouseId]) constraint).
authorizationRouter.post('/', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = applySchema.parse(req.body);

    const store = await prisma.resellerStore.findUnique({ where: { userId: req.user!.sub } });
    if (!store) throw new HttpError(400, 'Create your storefront before applying to a warehouse');

    const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse) throw new HttpError(404, 'Warehouse not found');

    const existing = await prisma.resellerAuthorization.findUnique({
      where: { storeId_warehouseId: { storeId: store.id, warehouseId: input.warehouseId } },
    });
    if (existing?.status === 'APPROVED') throw new HttpError(409, 'Already approved for this warehouse');
    if (existing?.status === 'PENDING') throw new HttpError(409, 'Application already pending');

    const authorization = await prisma.resellerAuthorization.upsert({
      where: { storeId_warehouseId: { storeId: store.id, warehouseId: input.warehouseId } },
      create: { storeId: store.id, warehouseId: input.warehouseId },
      update: { status: 'PENDING', decidedAt: null },
    });

    res.status(201).json(authorization);
  } catch (err) {
    next(err);
  }
});

// A reseller's view of their own applications, across every warehouse.
authorizationRouter.get('/mine', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const store = await prisma.resellerStore.findUnique({ where: { userId: req.user!.sub } });
    if (!store) return res.json([]);

    const authorizations = await prisma.resellerAuthorization.findMany({
      where: { storeId: store.id },
      include: { warehouse: { select: { id: true, name: true, parish: true } } },
      orderBy: { requestedAt: 'desc' },
    });
    res.json(authorizations);
  } catch (err) {
    next(err);
  }
});

const decideSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
});

async function assertOwnsAuthorization(authorizationId: string, userId: string, isAdmin: boolean) {
  const authorization = await prisma.resellerAuthorization.findUnique({
    where: { id: authorizationId },
    include: { warehouse: true },
  });
  if (!authorization) throw new HttpError(404, 'Application not found');
  if (authorization.warehouse.userId !== userId && !isAdmin) {
    throw new HttpError(403, 'You do not own this warehouse');
  }
  return authorization;
}

// A warehouse operator approves/rejects a pending application, or
// suspends/unsuspends (APPROVED <-> SUSPENDED) an existing reseller —
// suspending blocks new listings (see commerce.routes.ts) without touching
// their item grants or already-live listings; use DELETE to fully revoke.
authorizationRouter.patch('/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = decideSchema.parse(req.body);
    const authorization = await assertOwnsAuthorization(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const updated = await prisma.resellerAuthorization.update({
      where: { id: authorization.id },
      data: { status: input.status, decidedAt: new Date() },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Fully revokes a reseller's access to this warehouse: deletes the
// authorization, every item grant, and deactivates any of their listings
// sourced from this warehouse (so they don't linger on the marketplace).
authorizationRouter.delete('/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const authorization = await assertOwnsAuthorization(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    await prisma.$transaction([
      prisma.resellerProductGrant.deleteMany({
        where: { storeId: authorization.storeId, masterProduct: { warehouseId: authorization.warehouseId } },
      }),
      prisma.storeListing.updateMany({
        where: { storeId: authorization.storeId, masterProduct: { warehouseId: authorization.warehouseId } },
        data: { isActive: false },
      }),
      prisma.resellerAuthorization.delete({ where: { id: authorization.id } }),
    ]);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
