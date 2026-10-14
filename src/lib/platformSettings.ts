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
