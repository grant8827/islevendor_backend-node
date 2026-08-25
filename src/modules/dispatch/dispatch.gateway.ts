import type { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import { redis, DRIVER_GEO_KEY } from '../../lib/redis.js';
import type { AuthTokenPayload } from '../../middleware/auth.js';

const JOB_OFFER_TTL_SECONDS = 30;

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

    // Driver taps "Accept" on a JOB_OFFER push. First acceptor wins — the
    // Redis lock (SET NX, set when the offer went out) prevents two drivers
    // both being assigned the same order.
    socket.on('driver:acceptJob', async ({ orderId }: { orderId: string }) => {
      const lockKey = `job_offer:${orderId}`;
      const heldBy = await redis.get(lockKey);
      if (heldBy !== user.sub) {
        socket.emit('JOB_OFFER_EXPIRED', { orderId });
        return;
      }

      const order = await prisma.order.updateMany({
        where: { id: orderId, status: 'READY_FOR_PICKUP', driverId: null },
        data: { driverId: user.sub, status: 'PICKED_UP' },
      });
      if (order.count === 0) {
        socket.emit('JOB_OFFER_EXPIRED', { orderId });
        return;
      }

      await redis.del(lockKey);
      socket.emit('JOB_ASSIGNED', { orderId });
    });
  });
}

/** Called from dispatch.routes.ts when a warehouse marks an order READY_FOR_PICKUP. */
export async function offerJobToDriver(io: Server, orderId: string, driverId: string) {
  await redis.set(`job_offer:${orderId}`, driverId, 'EX', JOB_OFFER_TTL_SECONDS, 'NX');
  io.to(`driver_${driverId}`).emit('JOB_OFFER', { orderId, expiresInSeconds: JOB_OFFER_TTL_SECONDS });
}
