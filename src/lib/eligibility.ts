import type { ApplicantStatus, LedgerAccountType } from '@prisma/client';
import { prisma } from './prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// The one place that says what IsleVendor's admin approval actually gates.
// A warehouse, reseller store or shop that hasn't been approved (see the
// applicant review queue, modules/admin) can sign in and set itself up, but
// can't list, sell, dispatch or withdraw until it is:
//  - list:     add products, assign them to resellers, list them on a store
//  - sell:     appear in the marketplace or a storefront, or be checked out
//  - dispatch: send an order out for pickup
//  - withdraw: request a payout
// Drivers are gated the same way through lib/driverEligibility.ts.

/** Prisma filter: only sellers IsleVendor has approved. Spread into any public catalog query. */
export const APPROVED_SELLER = { applicantStatus: 'APPROVED' } as const;

const LABELS = { warehouse: 'warehouse', reseller: 'store', shop: 'store' } as const;

/** Throws 403 unless `entity` has been approved by IsleVendor. */
export function assertApprovedSeller(entity: { applicantStatus: ApplicantStatus }, kind: keyof typeof LABELS): void {
  if (entity.applicantStatus === 'APPROVED') return;
  throw new HttpError(
    403,
    entity.applicantStatus === 'REJECTED'
      ? `This ${LABELS[kind]}'s application was not approved by IsleVendor`
      : `This ${LABELS[kind]} is awaiting approval by IsleVendor — you can set it up now and start selling once it's approved`,
  );
}

/**
 * Whether `userId` may withdraw from a ledger account of `accountType`: they
 * must hold at least one approved business of that kind. A driver must be an
 * approved driver.
 */
export async function canWithdrawFrom(userId: string, accountType: LedgerAccountType): Promise<boolean> {
  const approved = { userId, ...APPROVED_SELLER };
  switch (accountType) {
    case 'WAREHOUSE':
      return (await prisma.warehouse.count({ where: approved })) > 0;
    case 'RESELLER':
      return (await prisma.resellerStore.count({ where: approved })) > 0;
    case 'STORE':
      return (await prisma.shop.count({ where: approved })) > 0;
    case 'DRIVER':
      return (await prisma.driverProfile.count({ where: approved })) > 0;
    case 'PLATFORM':
      return false;
  }
}

/**
 * For the dashboards' quick "add another warehouse/store" forms, which don't
 * collect bank details themselves: the owner must already have payout
 * details on file from their onboarding application.
 */
export async function assertHasPayoutDetails(userId: string): Promise<void> {
  const withPayout = { userId, payoutMethod: { not: null } } as const;
  const counts = await Promise.all([
    prisma.warehouse.count({ where: withPayout }),
    prisma.resellerStore.count({ where: withPayout }),
    prisma.shop.count({ where: withPayout }),
    prisma.driverProfile.count({ where: withPayout }),
  ]);
  if (counts.every((n) => n === 0)) {
    throw new HttpError(400, 'Add your bank or Lynk payout details first — apply through the IsleVendor sign-up form for your business type');
  }
}
