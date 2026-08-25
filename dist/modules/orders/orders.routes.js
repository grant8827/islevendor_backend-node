import { Router } from 'express';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
export const ordersRouter = Router();
// MVP flat/percentage config — will move to per-warehouse / distance-based
// values once the FastAPI routing service is wired up (Domain D, Phase 4).
const FLAT_DRIVER_FEE_JMD = new Decimal(300);
const PLATFORM_COMMISSION_RATE = new Decimal('0.10'); // 10% of retail total
const checkoutSchema = z.object({
    storeId: z.string().uuid(),
    masterProductId: z.string().uuid(),
    quantity: z.number().int().positive(),
    deliveryAddress: z.string().min(1),
});
ordersRouter.post('/', requireAuth, requireRole(UserRole.CUSTOMER, UserRole.ADMIN), async (req, res, next) => {
    try {
        const input = checkoutSchema.parse(req.body);
        const order = await prisma.$transaction(async (tx) => {
            const listing = await tx.storeListing.findFirst({
                where: { storeId: input.storeId, masterProductId: input.masterProductId, isActive: true },
                include: { masterProduct: true, store: true },
            });
            if (!listing)
                throw new HttpError(404, 'Listing not found or inactive');
            // Row-lock the product so two concurrent checkouts can't both pass the
            // stock check and oversell the last unit.
            const [locked] = await tx.$queryRaw `
        SELECT stock_quantity FROM master_products WHERE id = ${listing.masterProductId}::uuid FOR UPDATE
      `;
            if (!locked || locked.stock_quantity < input.quantity) {
                throw new HttpError(409, 'Not enough stock available');
            }
            const updated = await tx.$executeRaw `
        UPDATE master_products
        SET stock_quantity = stock_quantity - ${input.quantity}
        WHERE id = ${listing.masterProductId}::uuid AND stock_quantity >= ${input.quantity}
      `;
            if (updated === 0)
                throw new HttpError(409, 'Not enough stock available');
            const retailTotal = new Decimal(listing.retailPriceJmd.toString()).times(input.quantity);
            const wholesaleTotal = new Decimal(listing.masterProduct.wholesalePriceJmd.toString()).times(input.quantity);
            const resellerMargin = retailTotal.minus(wholesaleTotal);
            const driverFee = FLAT_DRIVER_FEE_JMD;
            const platformCommission = retailTotal.times(PLATFORM_COMMISSION_RATE).toDecimalPlaces(2);
            const totalPaid = retailTotal.plus(driverFee).plus(platformCommission);
            return tx.order.create({
                data: {
                    customerId: req.user.sub,
                    resellerStoreId: input.storeId,
                    warehouseId: listing.masterProduct.warehouseId,
                    totalPaidJmd: totalPaid.toFixed(2),
                    wholesaleTotalJmd: wholesaleTotal.toFixed(2),
                    resellerMarginJmd: resellerMargin.toFixed(2),
                    driverFeeJmd: driverFee.toFixed(2),
                    platformCommissionJmd: platformCommission.toFixed(2),
                    deliveryAddress: input.deliveryAddress,
                    // status defaults to AWAITING_PAYMENT — flips to PACKING only once
                    // the WiPay webhook confirms payment (see ledger.service.ts).
                },
            });
        });
        // TODO(Phase 3): initiate the WiPay hosted-fields checkout session here and
        // return its redirect/session URL alongside the order id.
        res.status(201).json(order);
    }
    catch (err) {
        next(err);
    }
});
ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
    try {
        const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
        if (!order)
            throw new HttpError(404, 'Order not found');
        res.json(order);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=orders.routes.js.map