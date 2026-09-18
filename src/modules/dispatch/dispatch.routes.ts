import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';
import { getSocketServer } from '../../lib/socket.js';
import { offerJobToDrivers, claimJobForDriver } from './dispatch.gateway.js';
import { logTrackingEvent } from '../../lib/tracking.js';

export const dispatchRouter = Router();

const DISPATCH_RADIUS_METERS = 10_000;
// Cap on how many online drivers get the broadcast — a genuine fan-out to
// "every online driver in range" is fine at this scale, but an unbounded
// LIMIT-less query is one to avoid regardless.
const MAX_DRIVERS_OFFERED = 20;

// Warehouse (or shop) finishes packing -> broadcast a JOB_OFFER to every
// online, KYC-approved driver within 10km at once (up to MAX_DRIVERS_OFFERED);
// first to accept gets it (see dispatch.gateway.ts's driver:acceptJob). The
// query still orders nearest-first — harmless to keep, just no longer
// meaningful now that every driver up to the cap gets the same offer at the
// same time rather than one at a time.
dispatchRouter.post('/orders/:id/ready', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const existing = await prisma.order.findUnique({
      where: { id: String(req.params.id) },
      include: { shop: true },
    });
    if (!existing) throw new HttpError(404, 'Order not found');

    if (existing.shopId) {
      if (existing.shop?.userId !== req.user!.sub && req.user!.role !== UserRole.ADMIN) {
        throw new HttpError(403, 'You do not own this order');
      }
    } else if (existing.warehouseId) {
      // Warehouse staff pack and dispatch orders too, not just the owner.
      await assertWarehouseAccess(existing.warehouseId, req.user!);
    } else {
      throw new HttpError(403, 'You do not own this order');
    }

    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { status: 'READY_FOR_PICKUP' },
    });
    await logTrackingEvent(prisma, order.id, 'READY_FOR_PICKUP', { note: 'Boxed and ready for pickup' });

    // Pickup point is the shop's location for a STORE order, the
    // warehouse's for an AFFILIATE order — never both.
    const nearbyDrivers = order.shopId
      ? await prisma.$queryRaw<{ user_id: string }[]>`
          SELECT dp.user_id
          FROM driver_profiles dp
          JOIN shops s ON s.id = ${order.shopId}::uuid
          WHERE dp.is_online = TRUE
            AND dp.is_kyc_approved = TRUE
            AND dp.current_location IS NOT NULL
            AND ST_DWithin(dp.current_location::geography, s.location::geography, ${DISPATCH_RADIUS_METERS})
          ORDER BY dp.current_location <-> s.location
          LIMIT ${MAX_DRIVERS_OFFERED}
        `
      : await prisma.$queryRaw<{ user_id: string }[]>`
          SELECT dp.user_id
          FROM driver_profiles dp
          JOIN warehouses w ON w.id = ${order.warehouseId}::uuid
          WHERE dp.is_online = TRUE
            AND dp.is_kyc_approved = TRUE
            AND dp.current_location IS NOT NULL
            AND ST_DWithin(dp.current_location::geography, w.location::geography, ${DISPATCH_RADIUS_METERS})
          ORDER BY dp.current_location <-> w.location
          LIMIT ${MAX_DRIVERS_OFFERED}
        `;

    if (nearbyDrivers.length === 0) {
      return res.json({ order, dispatched: false, reason: 'No available drivers within 10km' });
    }

    const driverIds = nearbyDrivers.map((d) => d.user_id);
    await offerJobToDrivers(getSocketServer(), order.id, driverIds);
    res.json({ order, dispatched: true, offeredTo: driverIds });
  } catch (err) {
    next(err);
  }
});

dispatchRouter.post('/orders/:id/delivered', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { proofOfDeliveryImageUrl } = req.body as { proofOfDeliveryImageUrl?: string };
    if (!proofOfDeliveryImageUrl) throw new HttpError(400, 'proofOfDeliveryImageUrl is required');

    const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.driverId !== req.user!.sub) throw new HttpError(403, 'You are not assigned to this order');

    const updated = await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', proofOfDeliveryImageUrl, deliveredAt: new Date() },
      });
      await logTrackingEvent(tx, order.id, 'DELIVERED', { note: 'Delivered', postedBy: req.user!.sub });

      // Escrow release: pending -> available for the seller (warehouse +
      // affiliate, or shop) leg now that delivery is confirmed. Driver/
      // platform payout wiring is Phase 6 (ACH batch generation). Moves the
      // actual balance columns too, not just the escrow_state label — a leg
      // still swept up by ledger.service.ts's withdrawBalance/refundOrder
      // either way, but refundOrder in particular decides which column to
      // subtract from based on escrow_state, so the two must stay in sync.
      const legs = await tx.ledgerTransaction.findMany({
        where: { orderId: order.id, escrowState: 'HELD_IN_ESCROW', reversedAt: null, payoutId: null },
      });
      for (const leg of legs) {
        await tx.$executeRaw`
          UPDATE ledger_accounts
          SET pending_balance_jmd = pending_balance_jmd - ${leg.amountJmd}, available_balance_jmd = available_balance_jmd + ${leg.amountJmd}
          WHERE id = ${leg.recipientAccountId}::uuid;
        `;
      }
      await tx.ledgerTransaction.updateMany({
        where: { id: { in: legs.map((leg) => leg.id) } },
        data: { escrowState: 'DISBURSED_TO_BANK' },
      });

      return updatedOrder;
    });

    // Live "delivered!" signal for whichever seller owns this order — the
    // warehouse/shop dashboard joins its own room (warehouse:join/shop:join,
    // see dispatch.gateway.ts) purely to receive this. Their Orders tab
    // already shows the proof photo on refresh regardless, so a client that
    // isn't connected/listening loses nothing but the live toast.
    const room = updated.shopId ? `shop_${updated.shopId}` : `warehouse_${updated.warehouseId}`;
    getSocketServer().to(room).emit('ORDER_DELIVERED', {
      orderId: updated.id,
      proofOfDeliveryImageUrl: updated.proofOfDeliveryImageUrl,
      deliveredAt: updated.deliveredAt,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const postNoteSchema = z.object({
  note: z.string().min(1),
});

// A driver's free-text update on an active delivery, without changing its
// status — "stuck in traffic", "buyer not answering the door", etc. Shows
// up on the warehouse/shop/reseller Orders tab's Tracking sub-tab alongside
// the automatic status-change events (see src/lib/tracking.ts).
dispatchRouter.post('/orders/:id/note', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { note } = postNoteSchema.parse(req.body);

    const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.driverId !== req.user!.sub) throw new HttpError(403, 'You are not assigned to this order');

    await logTrackingEvent(prisma, order.id, order.status, { note, postedBy: req.user!.sub });

    const room = order.shopId ? `shop_${order.shopId}` : `warehouse_${order.warehouseId}`;
    getSocketServer().to(room).emit('ORDER_TRACKING_UPDATE', { orderId: order.id, note });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Confirms physical pickup by scanning the QR code printed on the shipping
// label (see printLabel.js) — a second path into PICKED_UP alongside the
// in-app driver:acceptJob accept, for a driver who's physically holding the
// box but never got (or acted on) the in-app JOB_OFFER. Whoever scans first
// claims it, same as accepting in-app (see claimJobForDriver); re-scanning
// by the same already-assigned driver is a harmless no-op that just returns
// the order again, so this page can be safely reloaded/rescanned.
dispatchRouter.post('/orders/:id/scan-pickup', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const orderId = String(req.params.id);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new HttpError(404, 'Order not found');

    if (order.status === 'READY_FOR_PICKUP') {
      const claimed = await claimJobForDriver(getSocketServer(), orderId, req.user!.sub, 'Picked up (QR scan)');
      if (!claimed) throw new HttpError(409, 'This package was just claimed by another driver');
    } else if (!(order.status === 'PICKED_UP' && order.driverId === req.user!.sub)) {
      throw new HttpError(409, `This package can't be picked up right now (status: ${order.status.replaceAll('_', ' ')})`);
    }

    const full = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        customer: { select: { fullName: true, phoneNumber: true } },
        storeListing: { select: { masterProduct: { select: { title: true } } } },
        shopProduct: { select: { title: true } },
      },
    });
    res.json(full);
  } catch (err) {
    next(err);
  }
});
