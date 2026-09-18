import { UserRole, type Warehouse } from '@prisma/client';
import { prisma } from './prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { AuthTokenPayload } from '../middleware/auth.js';

// How a signed-in user relates to one warehouse. OWNER is Warehouse.userId
// (or a platform ADMIN); ADMIN/STAFF come from a WarehouseMember row — see
// the doc comment on WarehouseMember in schema.prisma for what each may do.
export type WarehouseAccess = 'OWNER' | 'ADMIN' | 'STAFF';

export interface WarehouseAccessResult {
  warehouse: Warehouse;
  access: WarehouseAccess;
}

export async function resolveWarehouseAccess(warehouse: Warehouse, user: AuthTokenPayload): Promise<WarehouseAccess | null> {
  if (user.role === UserRole.ADMIN || warehouse.userId === user.sub) return 'OWNER';
  const member = await prisma.warehouseMember.findUnique({
    where: { warehouseId_userId: { warehouseId: warehouse.id, userId: user.sub } },
    select: { role: true },
  });
  return member?.role ?? null;
}

/**
 * Loads a warehouse and confirms `user` may operate it. Throws 404/403
 * otherwise. `adminOnly` narrows that to the owner and ADMIN members — for
 * anything a plain STAFF login must not do (staff management, refunds,
 * commission changes).
 */
export async function assertWarehouseAccess(
  warehouseId: string,
  user: AuthTokenPayload,
  { adminOnly = false }: { adminOnly?: boolean } = {},
): Promise<WarehouseAccessResult> {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new HttpError(404, 'Warehouse not found');

  const access = await resolveWarehouseAccess(warehouse, user);
  if (!access) throw new HttpError(403, "You don't have access to this warehouse");
  if (adminOnly && access === 'STAFF') throw new HttpError(403, 'Only a warehouse admin can do this');
  return { warehouse, access };
}
