import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { getSocketServer } from '../../lib/socket.js';
import { offerJobToDriver } from './dispatch.gateway.js';
export const dispatchRouter = Router();
const DISPATCH_RADIUS_METERS = 10_000;
// Warehouse (or shop) finishes packing -> find the nearest online,
// KYC-approved driver within 10km and push them a JOB_OFFER. If nobody
// accepts within the offer TTL, a future retry/backoff job (Phase 4
// hardening) should re-run this against the next-nearest driver.
dispatchRouter.post('/orders/:id/ready', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
    try {
        const existing = await prisma.order.findUnique({
            where: { id: String(req.params.id) },
            include: { warehouse: true, shop: true },
        });
        if (!existing)
            throw new HttpError(404, 'Order not found');
        const isAdmin = req.user.role === UserRole.ADMIN;
        const ownsIt = existing.shopId
            ? existing.shop?.userId === req.user.sub
            : existing.warehouse?.userId === req.user.sub;
        if (!ownsIt && !isAdmin)
            throw new HttpError(403, 'You do not own this order');
        const order = await prisma.order.update({
            where: { id: existing.id },
            data: { status: 'READY_FOR_PICKUP' },
        });
        // Pickup point is the shop's location for a STORE order, the
        // warehouse's for an AFFILIATE order — never both.
        const nearbyDrivers = order.shopId
            ? await prisma.$queryRaw `
          SELECT dp.user_id
          FROM driver_profiles dp
          JOIN shops s ON s.id = ${order.shopId}::uuid
          WHERE dp.is_online = TRUE
            AND dp.is_kyc_approved = TRUE
            AND dp.current_location IS NOT NULL
            AND ST_DWithin(dp.current_location::geography, s.location::geography, ${DISPATCH_RADIUS_METERS})
          ORDER BY dp.current_location <-> s.location
          LIMIT 1
        `
            : await prisma.$queryRaw `
          SELECT dp.user_id
          FROM driver_profiles dp
          JOIN warehouses w ON w.id = ${order.warehouseId}::uuid
          WHERE dp.is_online = TRUE
            AND dp.is_kyc_approved = TRUE
            AND dp.current_location IS NOT NULL
            AND ST_DWithin(dp.current_location::geography, w.location::geography, ${DISPATCH_RADIUS_METERS})
          ORDER BY dp.current_location <-> w.location
          LIMIT 1
        `;
        if (nearbyDrivers.length === 0) {
            return res.json({ order, dispatched: false, reason: 'No available drivers within 10km' });
        }
        await offerJobToDriver(getSocketServer(), order.id, nearbyDrivers[0].user_id);
        res.json({ order, dispatched: true, offeredTo: nearbyDrivers[0].user_id });
    }
    catch (err) {
        next(err);
    }
});
dispatchRouter.post('/orders/:id/delivered', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
    try {
        const { proofOfDeliveryImageUrl } = req.body;
        if (!proofOfDeliveryImageUrl)
            throw new HttpError(400, 'proofOfDeliveryImageUrl is required');
        const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
        if (!order)
            throw new HttpError(404, 'Order not found');
        if (order.driverId !== req.user.sub)
            throw new HttpError(403, 'You are not assigned to this order');
        const updated = await prisma.$transaction(async (tx) => {
            const updatedOrder = await tx.order.update({
                where: { id: order.id },
                data: { status: 'DELIVERED', proofOfDeliveryImageUrl },
            });
            // Escrow release: pending -> available for the seller (warehouse +
            // affiliate, or shop) leg now that delivery is confirmed. Driver/
            // platform payout wiring is Phase 6 (ACH batch generation).
            await tx.$executeRaw `
        UPDATE ledger_transactions SET escrow_state = 'DISBURSED_TO_BANK'
        WHERE order_id = ${order.id}::uuid
      `;
            return updatedOrder;
        });
        res.json(updated);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=dispatch.routes.js.map