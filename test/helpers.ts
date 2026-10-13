import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { OrderStatus, UserRole } from '@prisma/client';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createServer } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { signAuthToken } from '../src/middleware/auth.js';

export { prisma, redis };

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boots the real app on an ephemeral port. Call `close` in an `after` hook. */
export async function startServer(): Promise<TestServer> {
  const { httpServer, io } = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: async () => {
      await io.close();
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

export interface TestUser {
  id: string;
  role: UserRole;
  token: string;
}

export async function createUser(role: UserRole): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@islevendor.test`,
      passwordHash: 'not-a-real-hash',
      fullName: `Test ${role}`,
      phoneNumber: '8760000000',
      role,
    },
  });
  return { id: user.id, role, token: signAuthToken({ sub: user.id, role }) };
}

export async function createDriver(opts: { isKycApproved?: boolean; applicantStatus?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' } = {}) {
  const user = await createUser('DRIVER');
  await prisma.driverProfile.create({
    data: {
      userId: user.id,
      isKycApproved: opts.isKycApproved ?? true,
      applicantStatus: opts.applicantStatus ?? 'APPROVED',
    },
  });
  return user;
}

// Warehouse/Shop have a PostGIS `location` column Prisma can't write, so —
// like the app's own create routes — these go through raw SQL.
export async function createWarehouse(ownerId: string): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO warehouses (id, user_id, name, address_line, parish, location)
    VALUES (${id}::uuid, ${ownerId}::uuid, 'Test Warehouse', '1 Test Road', 'Kingston',
            ST_SetSRID(ST_MakePoint(-76.79, 18.01), 4326))
  `;
  return id;
}

export async function createShop(ownerId: string): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO shops (id, user_id, shop_name, slug, address_line, parish, location)
    VALUES (${id}::uuid, ${ownerId}::uuid, 'Test Shop', ${`shop-${id}`}, '2 Test Road', 'Kingston',
            ST_SetSRID(ST_MakePoint(-76.79, 18.01), 4326))
  `;
  return id;
}

export async function createResellerStore(ownerId: string): Promise<string> {
  const store = await prisma.resellerStore.create({
    data: { userId: ownerId, storeName: 'Test Store', slug: `store-${randomUUID()}` },
  });
  return store.id;
}

export async function createOrder(data: {
  customerId: string;
  warehouseId?: string;
  resellerStoreId?: string;
  shopId?: string;
  driverId?: string;
  status?: OrderStatus;
}) {
  return prisma.order.create({
    data: {
      ...data,
      totalPaidJmd: '1500.00',
      wholesaleTotalJmd: '900.00',
      resellerMarginJmd: '200.00',
      driverFeeJmd: '300.00',
      platformCommissionJmd: '100.00',
      deliveryAddress: '12 Test Lane, Kingston',
    },
  });
}

export async function api(
  server: TestServer,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.baseUrl}/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const openSockets: Socket[] = [];

export async function openSocket(server: TestServer, token: string): Promise<Socket> {
  const socket = connectSocket(server.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

export function closeSockets() {
  for (const socket of openSockets.splice(0)) socket.disconnect();
}

/** Resolves with the first of `events` the socket receives. */
export function nextEvent(socket: Socket, events: string[], timeoutMs = 3000): Promise<{ event: string; payload: any }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${events.join(' / ')}`)), timeoutMs);
    for (const event of events) {
      socket.once(event, (payload) => {
        clearTimeout(timer);
        resolve({ event, payload });
      });
    }
  });
}
