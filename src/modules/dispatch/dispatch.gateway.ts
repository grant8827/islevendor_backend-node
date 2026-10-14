import type { Server, Socket } from 'socket.io';
import { prisma } from '../../lib/prisma.js';
import { redis, DRIVER_GEO_KEY } from '../../lib/redis.js';
import { verifyAuthToken, type AuthTokenPayload } from '../../middleware/auth.js';
import { userRoom } from '../../lib/sessions.js';
import { logTrackingEvent } from '../../lib/tracking.js';
import { resolveWarehouseAccess } from '../../lib/warehouseAccess.js';
import { isEligibleDriver } from '../../lib/driverEligibility.js';

const JOB_OFFER_TTL_SECONDS = 30;

// Which drivers a given order's JOB_OFFER went out to — set when the offer
// is broadcast (offerJobToDrivers), read once on the first accept so the
// other invited drivers can be told JOB_OFFER_TAKEN instead of silently
// timing out. Same TTL as the offer itself.
function offeredDriversKey(orderId: string): string {
  return `job_offer_drivers:${orderId}`;
}

// Socket payloads are whatever the client sent — never trust the declared type.
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function registerDispatchGateway(io: Server) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Missing auth token'));
    try {
      (socket.data as { user: AuthTokenPayload }).user = await verifyAuthToken(token);
      next();
    } catch {
      next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: AuthTokenPayload }).user;

    // Lets lib/sessions.ts drop every connection a user has when their
    // sessions are revoked — the handshake check alone would leave an
    // already-open socket running on a dead token.
    socket.join(userRoom(user.sub));

    if (user.role === 'DRIVER') {
      socket.join(`driver_${user.sub}`);
    }
    // Seller rooms carry that seller's live order/delivery events, so a join
    // is only honoured for someone who actually operates that warehouse/shop
    // — the role in the JWT alone isn't enough (any WAREHOUSE login could
    // otherwise listen in on any other warehouse by id). `ack` is optional:
    // DeliveryNotificationListener.jsx emits without one.
    type JoinAck = (result: { ok: boolean }) => void;
    const settleJoin = (room: string, allowed: boolean, ack?: JoinAck) => {
      if (allowed) socket.join(room);
      else console.warn(`[dispatch] denied room join: user=${user.sub} role=${user.role} room=${room}`);
      if (typeof ack === 'function') ack({ ok: allowed });
    };

    socket.on('warehouse:join', async (warehouseId: unknown, ack?: JoinAck) => {
      const room = `warehouse_${String(warehouseId)}`;
      try {
        const warehouse = isUuid(warehouseId) ? await prisma.warehouse.findUnique({ where: { id: warehouseId } }) : null;
        settleJoin(room, !!warehouse && !!(await resolveWarehouseAccess(warehouse, user)), ack);
      } catch (err) {
        console.error('[dispatch] warehouse:join failed', err);
        settleJoin(room, false, ack);
      }
    });

    socket.on('shop:join', async (shopId: unknown, ack?: JoinAck) => {
      const room = `shop_${String(shopId)}`;
      try {
        const shop = isUuid(shopId) ? await prisma.shop.findUnique({ where: { id: shopId }, select: { userId: true } }) : null;
        settleJoin(room, !!shop && (user.role === 'ADMIN' || shop.userId === user.sub), ack);
      } catch (err) {
        console.error('[dispatch] shop:join failed', err);
        settleJoin(room, false, ack);
      }
    });

    // Spec: device transmits lat/lng every ~10s while online.
    socket.on('driver:heartbeat', async ({ lat, lng }: { lat: number; lng: number }) => {
      if (user.role !== 'DRIVER') return;
      await redis.geoadd(DRIVER_GEO_KEY, lng, lat, user.sub);
      // Keep Postgres in sync too (source of truth for ST_DWithin dispatch
      // queries and for anything that needs a durable last-known position).
      await prisma.$executeRaw`
        UPDATE driver_profiles
        SET current_location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
        WHERE user_id = ${user.sub}::uuid
      `;
    });

    socket.on('driver:online', async (isOnline: boolean) => {
      if (user.role !== 'DRIVER') return;
      await prisma.driverProfile.update({ where: { userId: user.sub }, data: { isOnline } });
      if (!isOnline) await redis.zrem(DRIVER_GEO_KEY, user.sub);
    });

    // Driver taps "Accept" on a JOB_OFFER push. The order was broadcast to
    // every nearby online driver (offerJobToDrivers below), so first
    // acceptor wins — see claimJobForDriver below for the actual race-decider.
    socket.on('driver:acceptJob', async (payload: { orderId?: unknown } | undefined) => {
      const orderId = payload?.orderId;
      if (!isUuid(orderId)) return;
      try {
        // Three gates before the race-decider: an approved driver, who this
        // order was actually offered to, while that offer is still open (the
        // Redis set expires with it). Without them any logged-in socket that
        // knew an order id could make itself that order's driver.
        const allowed =
          (await isEligibleDriver(user)) && (await redis.sismember(offeredDriversKey(orderId), user.sub)) === 1;
        if (!allowed) {
          console.warn(`[dispatch] denied job claim: user=${user.sub} role=${user.role} order=${orderId}`);
          socket.emit('JOB_OFFER_EXPIRED', { orderId });
          return;
        }

        const claimed = await claimJobForDriver(io, orderId, user.sub, 'Picked up by driver');
        socket.emit(claimed ? 'JOB_ASSIGNED' : 'JOB_OFFER_EXPIRED', { orderId });
      } catch (err) {
        console.error('[dispatch] driver:acceptJob failed', err);
        socket.emit('JOB_OFFER_EXPIRED', { orderId });
      }
    });
  });
}

/**
 * Atomically assigns `orderId` to `driverId` and flips it PICKED_UP — the
 * `driverId: null` guard in this update is the actual race-decider (Postgres
 * only lets one concurrent request succeed), not a pre-check, since a
 * pre-check-then-write would itself race between two drivers claiming the
 * same job in the same instant. Shared by two claim paths: the in-app
 * `driver:acceptJob` socket event above, and dispatch.routes.ts's POST
 * /orders/:id/scan-pickup (the QR code printed on the shipping label —
 * see printLabel.js — for a driver who never got/used the in-app offer).
 * Returns false if the job was already claimed by someone else.
 *
 * Callers are responsible for authorizing `driverId` first — the socket path
 * by offer membership, the QR path by a signed pickup token.
 */
export async function claimJobForDriver(io: Server, orderId: string, driverId: string, note: string): Promise<boolean> {
  // One transaction, so an order can never end up assigned without its
  // PICKED_UP tracking event (or vice versa).
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.order.updateMany({
      // Only IsleDash orders are a driver's to take — a pickup or the
      // seller's own delivery never is, whatever a client sends.
      where: { id: orderId, status: 'READY_FOR_PICKUP', driverId: null, deliveryMethod: 'ISLEDASH' },
      data: { driverId, status: 'PICKED_UP' },
    });
    if (result.count === 0) return false;
    await logTrackingEvent(tx, orderId, 'PICKED_UP', { note, postedBy: driverId });
    return true;
  });
  if (!claimed) return false;

  // Tell the other drivers this offer went to that it's no longer available,
  // so their UI can drop it instead of waiting out the full offer window for
  // nothing.
  const offeredKey = offeredDriversKey(orderId);
  const otherDriverIds = await redis.smembers(offeredKey);
  for (const otherId of otherDriverIds) {
    if (otherId !== driverId) io.to(`driver_${otherId}`).emit('JOB_OFFER_TAKEN', { orderId });
  }
  await redis.del(offeredKey);

  return true;
}

/**
 * Called from dispatch.routes.ts when a warehouse/shop marks an order
 * READY_FOR_PICKUP — broadcasts a JOB_OFFER to every nearby online,
 * KYC-approved driver at once (not just the single nearest one); whoever
 * taps Accept first gets it, per the user's explicit direction over the
 * earlier single-nearest-driver design. `driverIds` is expected pre-sorted
 * nearest-first by the caller's query, though that ordering no longer
 * matters for who "wins" — it's a broadcast, not a queue.
 */
export async function offerJobToDrivers(io: Server, orderId: string, driverIds: string[]) {
  if (driverIds.length === 0) return;
  const offeredKey = offeredDriversKey(orderId);
  await redis.sadd(offeredKey, ...driverIds);
  await redis.expire(offeredKey, JOB_OFFER_TTL_SECONDS);
  for (const driverId of driverIds) {
    io.to(`driver_${driverId}`).emit('JOB_OFFER', { orderId, expiresInSeconds: JOB_OFFER_TTL_SECONDS });
  }
}
