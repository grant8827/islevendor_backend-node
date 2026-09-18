import type { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import { redis, DRIVER_GEO_KEY } from '../../lib/redis.js';
import type { AuthTokenPayload } from '../../middleware/auth.js';
import { logTrackingEvent } from '../../lib/tracking.js';

const JOB_OFFER_TTL_SECONDS = 30;

// Which drivers a given order's JOB_OFFER went out to — set when the offer
// is broadcast (offerJobToDrivers), read once on the first accept so the
// other invited drivers can be told JOB_OFFER_TAKEN instead of silently
// timing out. Same TTL as the offer itself.
function offeredDriversKey(orderId: string): string {
  return `job_offer_drivers:${orderId}`;
}

export function registerDispatchGateway(io: Server) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Missing auth token'));
    try {
      (socket.data as { user: AuthTokenPayload }).user = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
      next();
    } catch {
      next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: AuthTokenPayload }).user;

    if (user.role === 'DRIVER') {
      socket.join(`driver_${user.sub}`);
    }
    if (user.role === 'WAREHOUSE' || user.role === 'ADMIN') {
      socket.on('warehouse:join', (warehouseId: string) => socket.join(`warehouse_${warehouseId}`));
    }
    if (user.role === 'STORE' || user.role === 'ADMIN') {
      socket.on('shop:join', (shopId: string) => socket.join(`shop_${shopId}`));
    }

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
    socket.on('driver:acceptJob', async ({ orderId }: { orderId: string }) => {
      const claimed = await claimJobForDriver(io, orderId, user.sub, 'Picked up by driver');
      if (!claimed) {
        socket.emit('JOB_OFFER_EXPIRED', { orderId });
        return;
      }
      socket.emit('JOB_ASSIGNED', { orderId });
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
 */
export async function claimJobForDriver(io: Server, orderId: string, driverId: string, note: string): Promise<boolean> {
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: 'READY_FOR_PICKUP', driverId: null },
    data: { driverId, status: 'PICKED_UP' },
  });
  if (claimed.count === 0) return false;

  await logTrackingEvent(prisma, orderId, 'PICKED_UP', { note, postedBy: driverId });

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
