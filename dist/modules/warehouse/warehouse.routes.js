import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
export const warehouseRouter = Router();
const createWarehouseSchema = z.object({
    name: z.string().min(1),
    addressLine: z.string().min(1),
    parish: z.string().default('Kingston'),
    lat: z.number(),
    lng: z.number(),
});
// A warehouse operator registers their depot, including its spatial point —
// written via raw SQL since Prisma can't set a `geometry` column directly.
warehouseRouter.post('/', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
    try {
        const input = createWarehouseSchema.parse(req.body);
        // Raw INSERT bypasses Prisma Client's id generation (its @default(uuid())
        // is applied client-side, not as a DB DEFAULT) — generate it ourselves.
        const id = randomUUID();
        const [warehouse] = await prisma.$queryRaw `
      INSERT INTO warehouses (id, user_id, name, address_line, parish, location)
      VALUES (${id}::uuid, ${req.user.sub}::uuid, ${input.name}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326))
      RETURNING id
    `;
        res.status(201).json({ id: warehouse.id });
    }
    catch (err) {
        next(err);
    }
});
const createProductSchema = z.object({
    warehouseId: z.string().uuid(),
    sku: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    category: z.string().min(1),
    wholesalePriceJmd: z.number().positive(),
    stockQuantity: z.number().int().min(0).default(0),
    imageUrl: z.string().url().optional(),
});
warehouseRouter.post('/products', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
    try {
        const input = createProductSchema.parse(req.body);
        const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
        if (!warehouse)
            throw new HttpError(404, 'Warehouse not found');
        if (warehouse.userId !== req.user.sub && req.user.role !== UserRole.ADMIN) {
            throw new HttpError(403, 'You do not own this warehouse');
        }
        const product = await prisma.masterProduct.create({
            data: {
                warehouseId: input.warehouseId,
                sku: input.sku,
                title: input.title,
                description: input.description,
                category: input.category,
                wholesalePriceJmd: input.wholesalePriceJmd,
                stockQuantity: input.stockQuantity,
                imageUrl: input.imageUrl,
            },
        });
        res.status(201).json(product);
    }
    catch (err) {
        next(err);
    }
});
warehouseRouter.get('/products', async (req, res, next) => {
    try {
        const products = await prisma.masterProduct.findMany({
            where: { warehouseId: req.query.warehouseId },
            orderBy: { createdAt: 'desc' },
        });
        res.json(products);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=warehouse.routes.js.map