import { UserRole, type Order } from '@prisma/client';
import { prisma } from './prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { AuthTokenPayload } from '../middleware/auth.js';
import { resolveWarehouseAccess } from './warehouseAccess.js';

// How a signed-in user relates to one order. Exactly one applies; the first
// match below wins. Anyone with no relationship gets null (and a 404 from
// assertOrderAccess — never a 403, which would confirm the order exists).
export type OrderAccess = 'ADMIN' | 'CUSTOMER' | 'DRIVER' | 'WAREHOUSE' | 'RESELLER' | 'SHOP';

export async function resolveOrderAccess(order: Order, user: AuthTokenPayload): Promise<OrderAccess | null> {
  if (user.role === UserRole.ADMIN) return 'ADMIN';
  if (order.customerId === user.sub) return 'CUSTOMER';
  // Only the *assigned* driver — an order that was merely offered to a
  // driver isn't theirs to read until they've claimed it.
  if (order.driverId && order.driverId === user.sub) return 'DRIVER';

  if (order.shopId) {
    const shop = await prisma.shop.findUnique({ where: { id: order.shopId }, select: { userId: true } });
    if (shop?.userId === user.sub) return 'SHOP';
  }
  if (order.warehouseId) {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: order.warehouseId } });
    // Owner or any WarehouseMember — staff pack and dispatch orders too.
    if (warehouse && (await resolveWarehouseAccess(warehouse, user))) return 'WAREHOUSE';
  }
  if (order.resellerStoreId) {
    const store = await prisma.resellerStore.findUnique({ where: { id: order.resellerStoreId }, select: { userId: true } });
    if (store?.userId === user.sub) return 'RESELLER';
  }
  return null;
}

/** Loads an order and confirms `user` is a participant. Throws 404 otherwise. */
export async function assertOrderAccess(orderId: string, user: AuthTokenPayload): Promise<{ order: Order; access: OrderAccess }> {
  // A malformed id would otherwise surface as a Prisma error -> 500.
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(404, 'Order not found');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  const access = order ? await resolveOrderAccess(order, user) : null;
  if (!order || !access) throw new HttpError(404, 'Order not found');
  return { order, access };
}

/**
 * The slice of an order each participant may see. Everyone gets the
 * fulfilment basics; money fields are limited to the legs that are the
 * viewer's own business — a customer sees what they paid, a driver their
 * fee, a warehouse its wholesale total, a reseller/shop its own take — and
 * only an ADMIN sees the full split.
 */
export function toOrderDto(order: Order, access: OrderAccess) {
  const base = {
    id: order.id,
    status: order.status,
    quantity: order.quantity,
    storeListingId: order.storeListingId,
    shopProductId: order.shopProductId,
    deliveryAddress: order.deliveryAddress,
    deliveredAt: order.deliveredAt,
    createdAt: order.createdAt,
  };

  switch (access) {
    case 'ADMIN':
      return order;
    case 'CUSTOMER':
      return {
        ...base,
        resellerStoreId: order.resellerStoreId,
        shopId: order.shopId,
        totalPaidJmd: order.totalPaidJmd,
        driverFeeJmd: order.driverFeeJmd,
        proofOfDeliveryImageUrl: order.proofOfDeliveryImageUrl,
      };
    case 'DRIVER':
      return {
        ...base,
        warehouseId: order.warehouseId,
        shopId: order.shopId,
        driverFeeJmd: order.driverFeeJmd,
        proofOfDeliveryImageUrl: order.proofOfDeliveryImageUrl,
      };
    case 'WAREHOUSE':
      return {
        ...base,
        warehouseId: order.warehouseId,
        resellerStoreId: order.resellerStoreId,
        driverId: order.driverId,
        wholesaleTotalJmd: order.wholesaleTotalJmd,
        proofOfDeliveryImageUrl: order.proofOfDeliveryImageUrl,
      };
    case 'RESELLER':
      return {
        ...base,
        warehouseId: order.warehouseId,
        resellerStoreId: order.resellerStoreId,
        totalPaidJmd: order.totalPaidJmd,
        resellerMarginJmd: order.resellerMarginJmd,
      };
    case 'SHOP':
      return {
        ...base,
        shopId: order.shopId,
        driverId: order.driverId,
        totalPaidJmd: order.totalPaidJmd,
        resellerMarginJmd: order.resellerMarginJmd,
        driverFeeJmd: order.driverFeeJmd,
        platformCommissionJmd: order.platformCommissionJmd,
        proofOfDeliveryImageUrl: order.proofOfDeliveryImageUrl,
      };
  }
}
