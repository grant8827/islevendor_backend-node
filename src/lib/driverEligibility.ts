import { UserRole } from '@prisma/client';
import { prisma } from './prisma.js';
import type { AuthTokenPayload } from '../middleware/auth.js';

/**
 * The one place that decides whether a user may take delivery jobs. Mirrors
 * the `is_kyc_approved = TRUE` filter dispatch.routes.ts uses when choosing
 * who to offer a job to, plus a REJECTED applicant can never claim one.
 *
 * isKycApproved and applicantStatus are still two separate flags (the admin
 * decision endpoint only writes applicantStatus) — when those are unified,
 * this function is the only claim-side check that needs to change.
 */
export async function isEligibleDriver(user: AuthTokenPayload): Promise<boolean> {
  if (user.role !== UserRole.DRIVER) return false;
  const profile = await prisma.driverProfile.findUnique({
    where: { userId: user.sub },
    select: { isKycApproved: true, applicantStatus: true },
  });
  return !!profile && profile.isKycApproved && profile.applicantStatus !== 'REJECTED';
}

/**
 * Whether this driver has been accepted to deliver for the business that
 * packs `order` — the warehouse for a reseller order, the shop for a store
 * order. Each business picks its own couriers (DeliveryApplication); being
 * an approved IsleVendor driver isn't enough on its own.
 */
export async function isAcceptedByOrderSeller(
  driverUserId: string,
  order: { warehouseId: string | null; shopId: string | null },
): Promise<boolean> {
  const seller = order.shopId ? { shopId: order.shopId } : order.warehouseId ? { warehouseId: order.warehouseId } : null;
  if (!seller) return false;
  const accepted = await prisma.deliveryApplication.count({
    where: { ...seller, status: 'APPROVED', driver: { userId: driverUserId } },
  });
  return accepted > 0;
}
