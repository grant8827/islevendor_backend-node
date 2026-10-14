import { Decimal } from 'decimal.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';
import type { ShippingRate } from './deliveryOptions.js';

const SETTINGS_ID = 'default';

// What the migration seeds; used if the row is ever missing so checkout
// never fails for want of a settings row.
const DEFAULT_ISLEDASH_RATE: ShippingRate = { baseFeeJmd: new Decimal(300), extraItemPercent: 50 };

/** IsleVendor's IsleDash delivery rate, as set in the admin console. */
export async function getIsleDashRate(db: PrismaClient | Prisma.TransactionClient = prisma): Promise<ShippingRate> {
  const row = await db.platformSetting.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) return DEFAULT_ISLEDASH_RATE;
  return { baseFeeJmd: new Decimal(row.isleDashBaseFeeJmd.toString()), extraItemPercent: row.isleDashExtraItemPercent };
}

export async function setIsleDashRate(rate: { baseFeeJmd: number; extraItemPercent: number }, updatedBy: string, db: PrismaClient | Prisma.TransactionClient = prisma) {
  const data = { isleDashBaseFeeJmd: rate.baseFeeJmd, isleDashExtraItemPercent: rate.extraItemPercent, updatedBy };
  return db.platformSetting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

export interface PayoutTiming {
  minBusinessDays: number;
  maxBusinessDays: number;
}

const DEFAULT_PAYOUT_TIMING: PayoutTiming = { minBusinessDays: 2, maxBusinessDays: 5 };

/** How long a withdrawal usually takes to reach someone's bank, as set in the admin console. */
export async function getPayoutTiming(db: PrismaClient | Prisma.TransactionClient = prisma): Promise<PayoutTiming> {
  const row = await db.platformSetting.findUnique({ where: { id: SETTINGS_ID } });
  return row ? { minBusinessDays: row.payoutMinBusinessDays, maxBusinessDays: row.payoutMaxBusinessDays } : DEFAULT_PAYOUT_TIMING;
}

export async function setPayoutTiming(timing: PayoutTiming, updatedBy: string, db: PrismaClient | Prisma.TransactionClient = prisma) {
  const data = { payoutMinBusinessDays: timing.minBusinessDays, payoutMaxBusinessDays: timing.maxBusinessDays, updatedBy };
  return db.platformSetting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

/**
 * `days` business days after `from`, skipping Saturdays and Sundays (in
 * Jamaica's time zone, UTC-5 all year). Public holidays aren't counted, so
 * the estimate can run a day short around them.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const JAMAICA_OFFSET_MS = 5 * 60 * 60 * 1000;
  const date = new Date(from.getTime() - JAMAICA_OFFSET_MS);
  date.setUTCHours(0, 0, 0, 0);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date;
}
