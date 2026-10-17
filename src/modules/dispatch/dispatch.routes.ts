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
import { ITEMS_IN_ORDER, toItemView } from '../../lib/orderItems.js';
import { consumePickupToken, issuePickupToken, verifyPickupToken } from '../../lib/pickupToken.js';
import { checkDeliveryPhoto } from '../../lib/ocrClient.js';
import { localUpload } from '../uploads/uploads.routes.js';

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

const deliveredSchema = z.object({
  proofOfDeliveryImageUrl: z.string().min(1, 'proofOfDeliveryImageUrl is required').max(500),
  // What the photo shows: the package with the recipient's ID, or with the
  // recipient. The driver picks one and confirms the photo shows it.
  proofType: z.enum(['PACKAGE_WITH_ID', 'PACKAGE_WITH_RECIPIENT'], {
    message: 'Say what the photo shows: the package with the recipient, or with their ID',
  }),
  confirmed: z.literal(true, { message: 'Confirm the photo clearly shows the package and the recipient or their ID' }),
});

const PROOF_LABELS = { PACKAGE_WITH_ID: "the package with the recipient's ID", PACKAGE_WITH_RECIPIENT: 'the package with the recipient' } as const;

dispatchRouter.post('/orders/:id/delivered', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { proofOfDeliveryImageUrl, proofType } = deliveredSchema.parse(req.body ?? {});

    const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.driverId !== req.user!.sub) throw new HttpError(403, 'You are not assigned to this order');
    if (order.status !== 'PICKED_UP') {
      throw new HttpError(409, `This order can't be marked delivered (status: ${order.status.replaceAll('_', ' ')}) — scan the label when you collect it first`);
    }

    // backend-fastapi looks for the person or ID the photo should show. It
    // never blocks the delivery — a FLAGGED photo is for the seller and an
    // admin to look at (a dark doorstep shouldn't leave a driver stuck).
    const file = localUpload(proofOfDeliveryImageUrl);
    const photo = file ? await checkDeliveryPhoto(file.path, file.mimeType, proofType) : { check: 'NOT_CHECKED' as const, note: 'The photo isn’t stored on this server' };

    const updated = await prisma.$transaction(async (tx) => {
      // PICKED_UP -> DELIVERED, once. The status condition is the
      // race-decider: a repeated or concurrent call matches zero rows, so
      // escrow below can only ever be released a single time per order, and
      // never for one that was refunded or isn't out for delivery.
      const delivered = await tx.order.updateMany({
        where: { id: order.id, driverId: req.user!.sub, status: 'PICKED_UP' },
        data: {
          status: 'DELIVERED',
          proofOfDeliveryImageUrl,
          proofOfDeliveryType: proofType,
          proofOfDeliveryCheck: photo.check,
          proofOfDeliveryNote: photo.note,
          deliveredAt: new Date(),
        },
      });
      if (delivered.count === 0) {
        throw new HttpError(409, `This order can't be marked delivered (status: ${order.status.replaceAll('_', ' ')})`);
      }
      const flagged = photo.check === 'FLAGGED' ? ` — photo flagged for a look: ${photo.note}` : '';
      await logTrackingEvent(tx, order.id, 'DELIVERED', { note: `Delivered — photo of ${PROOF_LABELS[proofType]}${flagged}`, postedBy: req.user!.sub });

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
      proofOfDeliveryCheck: updated.proofOfDeliveryCheck,
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
// label (see printLabel.js) — the only way an IsleDash order becomes
// PICKED_UP. Two cases:
//  - The driver accepted the job in the app (it's assigned to them, still
//    READY_FOR_PICKUP): scanning at the seller marks it picked up.
//  - Nobody has the job yet, and a driver holding the box scans it: they
//    claim it and pick it up in one step. Whoever scans first wins, same as
//    accepting in-app (see claimJobForDriver).
// Re-scanning a package already picked up by the same driver is a harmless
// no-op that just returns the order again, so the scan can be retried.
//
// Picking up needs the label's signed token, not just the order id in the
// URL — the token is the proof of holding the physical label — and it's
// burned on success. Every failure a caller without the package can hit
// returns the same 403, so this endpoint can't be used to probe order ids.
dispatchRouter.post('/orders/:id/scan-pickup', requireAuth, requireRole(UserRole.DRIVER), async (req, res, next) => {
  try {
    const orderId = String(req.params.id);
    const { token } = scanPickupSchema.parse(req.body ?? {});
    const driverId = req.user!.sub;
    const denied = new HttpError(403, 'This pickup code is invalid or has expired — ask the seller to reprint the label');

    if (!(await isEligibleDriver(req.user!))) {
      throw new HttpError(403, 'Your driver account is not approved for deliveries yet');
    }

    const order = /^[0-9a-f-]{36}$/i.test(orderId) ? await prisma.order.findUnique({ where: { id: orderId } }) : null;
    const alreadyPickedUp = order?.status === 'PICKED_UP' && order.driverId === driverId;

    if (!alreadyPickedUp) {
      const nonce = order ? await verifyPickupToken(orderId, token) : null;
      if (!order || !nonce) throw denied;
      // Someone else accepted this job.
      if (order.driverId && order.driverId !== driverId) throw denied;
      // Holding the label isn't enough: only a courier this business has
      // accepted may take its packages.
      if (!(await isAcceptedByOrderSeller(driverId, order))) {
        throw new HttpError(403, "You aren't one of this business's accepted drivers — apply to deliver for them first");
      }
      if (order.status !== 'READY_FOR_PICKUP') {
        throw new HttpError(409, `This package can't be picked up right now (status: ${order.status.replaceAll('_', ' ')})`);
      }

      if (order.driverId === driverId) {
        // Accepted in the app earlier; now actually collected.
        const pickedUp = await prisma.$transaction(async (tx) => {
          const result = await tx.order.updateMany({
            where: { id: orderId, driverId, status: 'READY_FOR_PICKUP' },
            data: { status: 'PICKED_UP' },
          });
          if (result.count === 0) return false;
          await logTrackingEvent(tx, orderId, 'PICKED_UP', { note: 'Picked up — label scanned', postedBy: driverId });
          return true;
        });
        if (!pickedUp) throw new HttpError(409, 'This package was just picked up');
      } else {
        const claimed = await claimJobForDriver(getSocketServer(), orderId, driverId, 'Picked up — label scanned', { pickedUp: true });
        if (!claimed) throw new HttpError(409, 'This package was just claimed by another driver');
      }
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
        items: ITEMS_IN_ORDER,
      },
    });
    const { customer, storeListing, shopProduct, items, ...order_ } = full;
    res.json({ ...toOrderDto(order_, 'DRIVER'), customer, storeListing, shopProduct, items: items.map(toItemView) });
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
