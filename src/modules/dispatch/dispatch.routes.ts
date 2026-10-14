import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole, type AuthTokenPayload } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';
import { getSocketServer } from '../../lib/socket.js';
import { offerJobToDrivers, claimJobForDriver } from './dispatch.gateway.js';
import { logTrackingEvent } from '../../lib/tracking.js';
import { env } from '../../env.js';
import { toOrderDto } from '../../lib/orderAccess.js';
import { isAcceptedByOrderSeller, isEligibleDriver } from '../../lib/driverEligibility.js';
import { assertApprovedSeller } from '../../lib/eligibility.js';
import { releaseEscrowForOrder } from '../ledger/ledger.service.js';
import { consumePickupToken, issuePickupToken, verifyPickupToken } from '../../lib/pickupToken.js';

export const dispatchRouter = Router();

const DISPATCH_RADIUS_METERS = 10_000;
// Cap on how many online drivers get the broadcast — a genuine fan-out to
// "every online driver in range" is fine at this scale, but an unbounded
// LIMIT-less query is one to avoid regardless.
const MAX_DRIVERS_OFFERED = 20;

const READY_NOTES = {
  ISLEDASH: 'Boxed and ready for pickup',
  PICKUP: 'Ready for the customer to collect',
  SELLER_DELIVERY: 'Ready to go out with the seller’s own delivery',
} as const;

/** Loads an order and confirms `user` is the shop/warehouse that packs it. */
async function loadOrderForSeller(orderId: string, user: AuthTokenPayload) {
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    include: { shop: true },
  });
  if (!existing) throw new HttpError(404, 'Order not found');

  if (existing.shopId) {
    if (existing.shop?.userId !== user.sub && user.role !== UserRole.ADMIN) {
      throw new HttpError(403, 'You do not own this order');
    }
  } else if (existing.warehouseId) {
    // Warehouse staff pack and dispatch orders too, not just the owner.
    const { warehouse } = await assertWarehouseAccess(existing.warehouseId, user);
    assertApprovedSeller(warehouse, 'warehouse');
  } else {
    throw new HttpError(403, 'You do not own this order');
  }
  if (existing.shop) assertApprovedSeller(existing.shop, 'shop');
  return existing;
}

// Warehouse (or shop) finishes packing -> broadcast a JOB_OFFER to every
// online, KYC-approved driver within 10km *whom this business has accepted
// as one of its couriers* (an APPROVED DeliveryApplication) at once (up to
// MAX_DRIVERS_OFFERED);
// first to accept gets it (see dispatch.gateway.ts's driver:acceptJob). The
// query still orders nearest-first — harmless to keep, just no longer
// meaningful now that every driver up to the cap gets the same offer at the
// same time rather than one at a time.
dispatchRouter.post('/orders/:id/ready', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const existing = await loadOrderForSeller(String(req.params.id), req.user!);

    // PACKING -> READY_FOR_PICKUP, once: a repeated press (or an order that
    // isn't paid for yet, or was refunded) changes nothing.
    const moved = await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({ where: { id: existing.id, status: 'PACKING' }, data: { status: 'READY_FOR_PICKUP' } });
      if (result.count === 0) return false;
      await logTrackingEvent(tx, existing.id, 'READY_FOR_PICKUP', { note: READY_NOTES[existing.deliveryMethod] });
      return true;
    });
    if (!moved) {
      throw new HttpError(409, `This order can't be marked ready (status: ${existing.status.replaceAll('_', ' ')})`);
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: existing.id } });

    // Only IsleDash orders go out to drivers. A pickup waits for the
    // customer; the seller's own delivery is theirs to run — either way the
    // seller finishes it with POST /orders/:id/complete below.
    if (order.deliveryMethod !== 'ISLEDASH') {
      return res.json({ order, dispatched: false, reason: READY_NOTES[order.deliveryMethod] });
    }

    // Pickup point is the shop's location for a STORE order, the
    // warehouse's for an AFFILIATE order — never both.
    const nearbyDrivers = order.shopId
      ? await prisma.$queryRaw<{ user_id: string }[]>`
          SELECT dp.user_id
          FROM driver_profiles dp
          JOIN shops s ON s.id = ${order.shopId}::uuid
          JOIN delivery_applications da
            ON da.driver_id = dp.id AND da.shop_id = s.id AND da.status = 'APPROVED'
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
          JOIN delivery_applications da
            ON da.driver_id = dp.id AND da.warehouse_id = w.id AND da.status = 'APPROVED'
          WHERE dp.is_online = TRUE
            AND dp.is_kyc_approved = TRUE
            AND dp.current_location IS NOT NULL
            AND ST_DWithin(dp.current_location::geography, w.location::geography, ${DISPATCH_RADIUS_METERS})
          ORDER BY dp.current_location <-> w.location
          LIMIT ${MAX_DRIVERS_OFFERED}
        `;

    if (nearbyDrivers.length === 0) {
      return res.json({ order, dispatched: false, reason: 'None of your accepted drivers are online within 10km' });
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
      // PICKED_UP -> DELIVERED, once. The status condition is the
      // race-decider: a repeated or concurrent call matches zero rows, so
      // escrow below can only ever be released a single time per order, and
      // never for one that was refunded or isn't out for delivery.
      const delivered = await tx.order.updateMany({
        where: { id: order.id, driverId: req.user!.sub, status: 'PICKED_UP' },
        data: { status: 'DELIVERED', proofOfDeliveryImageUrl, deliveredAt: new Date() },
      });
      if (delivered.count === 0) {
        throw new HttpError(409, `This order can't be marked delivered (status: ${order.status.replaceAll('_', ' ')})`);
      }
      await logTrackingEvent(tx, order.id, 'DELIVERED', { note: 'Delivered', postedBy: req.user!.sub });

      await releaseEscrowForOrder(tx, order.id);

      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
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

// Mints the signed, expiring token a shipping label's QR code carries (see
// printLabel.js and lib/pickupToken.ts). Called each time the seller prints
// a label; printing again invalidates the earlier label's token.
dispatchRouter.post('/orders/:id/pickup-token', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const order = await loadOrderForSeller(String(req.params.id), req.user!);
    if (order.status !== 'PACKING' && order.status !== 'READY_FOR_PICKUP') {
      throw new HttpError(409, `A pickup label can't be issued for this order (status: ${order.status.replaceAll('_', ' ')})`);
    }
    if (order.deliveryMethod !== 'ISLEDASH') {
      throw new HttpError(409, 'This order isn’t going out with IsleDash, so it has no driver pickup code');
    }
    res.status(201).json(await issuePickupToken(order.id));
  } catch (err) {
    next(err);
  }
});

const scanPickupSchema = z.object({
  token: z.string().min(1).max(200).optional(),
});

// Confirms physical pickup by scanning the QR code printed on the shipping
// label (see printLabel.js) — a second path into PICKED_UP alongside the
// in-app driver:acceptJob accept, for a driver who's physically holding the
// box but never got (or acted on) the in-app JOB_OFFER. Whoever scans first
// claims it, same as accepting in-app (see claimJobForDriver); re-scanning
// by the same already-assigned driver is a harmless no-op that just returns
// the order again, so this page can be safely reloaded/rescanned.
//
// Claiming needs the label's signed token, not just the order id in the URL
// — the token is the proof of holding the physical label — and it's burned
// on the first successful claim. Every failure a non-assigned caller can hit
// returns the same 403, so this endpoint can't be used to probe order ids.
dispatchRouter.post('/orders/:id/scan-pickup', requireAuth, requireRole(UserRole.DRIVER), async (req, res, next) => {
  try {
    const orderId = String(req.params.id);
    const { token } = scanPickupSchema.parse(req.body ?? {});
    const denied = new HttpError(403, 'This pickup code is invalid or has expired — ask the seller to reprint the label');

    if (!(await isEligibleDriver(req.user!))) {
      throw new HttpError(403, 'Your driver account is not approved for deliveries yet');
    }

    const order = /^[0-9a-f-]{36}$/i.test(orderId) ? await prisma.order.findUnique({ where: { id: orderId } }) : null;
    const alreadyMine = order?.status === 'PICKED_UP' && order.driverId === req.user!.sub;

    if (!alreadyMine) {
      const nonce = order ? await verifyPickupToken(orderId, token) : null;
      if (!order || !nonce) throw denied;
      // Holding the label isn't enough: only a courier this business has
      // accepted may take its packages.
      if (!(await isAcceptedByOrderSeller(req.user!.sub, order))) {
        throw new HttpError(403, "You aren't one of this business's accepted drivers — apply to deliver for them first");
      }

      if (order.status !== 'READY_FOR_PICKUP') {
        throw new HttpError(409, `This package can't be picked up right now (status: ${order.status.replaceAll('_', ' ')})`);
      }
      const claimed = await claimJobForDriver(getSocketServer(), orderId, req.user!.sub, 'Picked up (QR scan)');
      if (!claimed) throw new HttpError(409, 'This package was just claimed by another driver');
      await consumePickupToken(orderId, nonce);
    }

    // The driver's slice of the order (see lib/orderAccess.ts) plus who and
    // what they're delivering — not the seller/platform money split.
    const full = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        customer: { select: { fullName: true, phoneNumber: true } },
        storeListing: { select: { masterProduct: { select: { title: true } } } },
        shopProduct: { select: { title: true } },
      },
    });
    const { customer, storeListing, shopProduct, ...order_ } = full;
    res.json({ ...toOrderDto(order_, 'DRIVER'), customer, storeListing, shopProduct });
  } catch (err) {
    next(err);
  }
});

const completeSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

// The seller finishes an order that didn't go out with IsleDash: the
// customer collected it (PICKUP), or the seller's own delivery dropped it
// off (SELLER_DELIVERY). READY_FOR_PICKUP -> DELIVERED, once, releasing
// escrow exactly as a driver's delivery would (see /orders/:id/delivered).
dispatchRouter.post('/orders/:id/complete', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { note } = completeSchema.parse(req.body ?? {});
    const existing = await loadOrderForSeller(String(req.params.id), req.user!);
    if (existing.deliveryMethod === 'ISLEDASH') {
      throw new HttpError(409, 'IsleDash orders are completed by the driver who delivers them');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const done = await tx.order.updateMany({
        where: { id: existing.id, status: 'READY_FOR_PICKUP' },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });
      if (done.count === 0) {
        throw new HttpError(409, `This order can't be completed (status: ${existing.status.replaceAll('_', ' ')}) — mark it ready first`);
      }
      const what = existing.deliveryMethod === 'PICKUP' ? 'Collected by the customer' : 'Delivered by the seller';
      await logTrackingEvent(tx, existing.id, 'DELIVERED', { note: note ? `${what} — ${note}` : what, postedBy: req.user!.sub });
      await releaseEscrowForOrder(tx, existing.id);
      return tx.order.findUniqueOrThrow({ where: { id: existing.id } });
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
