import { Decimal } from 'decimal.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';
import type { IsleDashPricing } from './isleDashPricing.js';
import { env } from '../env.js';

const SETTINGS_ID = 'default';

// What the migrations seed; used if the row is ever missing so checkout
// never fails for want of a settings row. Price per mile 0: a flat fee.
const DEFAULT_ISLEDASH_PRICING: IsleDashPricing = {
  baseFeeJmd: new Decimal(300),
  includedMiles: new Decimal(0),
  perMileJmd: new Decimal(0),
  minFeeJmd: new Decimal(0),
  maxFeeJmd: null,
  maxMiles: null,
  extraItemPercent: 50,
  fallbackFeeJmd: new Decimal(300),
  roadAdjustPercent: 30,
};

const dec = (v: Prisma.Decimal) => new Decimal(v.toString());

/** IsleVendor's IsleDash delivery pricing, as set in Admin → Settings → Shipping. */
export async function getIsleDashPricing(db: PrismaClient | Prisma.TransactionClient = prisma): Promise<IsleDashPricing> {
  const row = await db.platformSetting.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) return DEFAULT_ISLEDASH_PRICING;
  return {
    baseFeeJmd: dec(row.isleDashBaseFeeJmd),
    includedMiles: dec(row.isleDashIncludedMiles),
    perMileJmd: dec(row.isleDashPerMileJmd),
    minFeeJmd: dec(row.isleDashMinFeeJmd),
    maxFeeJmd: row.isleDashMaxFeeJmd === null ? null : dec(row.isleDashMaxFeeJmd),
    maxMiles: row.isleDashMaxMiles === null ? null : dec(row.isleDashMaxMiles),
    extraItemPercent: row.isleDashExtraItemPercent,
    fallbackFeeJmd: dec(row.isleDashFallbackFeeJmd),
    roadAdjustPercent: row.isleDashRoadAdjustPercent,
  };
}

export interface IsleDashPricingInput {
  baseFeeJmd: number;
  includedMiles: number;
  perMileJmd: number;
  minFeeJmd: number;
  maxFeeJmd: number | null;
  maxMiles: number | null;
  extraItemPercent: number;
  fallbackFeeJmd: number;
  roadAdjustPercent: number;
}

export async function setIsleDashPricing(p: IsleDashPricingInput, updatedBy: string, db: PrismaClient | Prisma.TransactionClient = prisma) {
  const data = {
    isleDashBaseFeeJmd: p.baseFeeJmd,
    isleDashIncludedMiles: p.includedMiles,
    isleDashPerMileJmd: p.perMileJmd,
    isleDashMinFeeJmd: p.minFeeJmd,
    isleDashMaxFeeJmd: p.maxFeeJmd,
    isleDashMaxMiles: p.maxMiles,
    isleDashExtraItemPercent: p.extraItemPercent,
    isleDashFallbackFeeJmd: p.fallbackFeeJmd,
    isleDashRoadAdjustPercent: p.roadAdjustPercent,
    updatedBy,
  };
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

// ── IsleVendor Pay settings ─────────────────────────────────────────────────

export type FeeStructure = 'merchant_absorb' | 'customer_pay' | 'split';
const FEE_STRUCTURES: FeeStructure[] = ['merchant_absorb', 'customer_pay', 'split'];

export interface PaySettings {
  paymentsEnabled: boolean;
  automatedPayoutsEnabled: boolean;
  /** null: use WIPAY_FEE_STRUCTURE from the environment. */
  wipayFeeStructure: FeeStructure | null;
  platformCommissionPercent: Decimal;
}

const DEFAULT_PAY_SETTINGS: PaySettings = {
  paymentsEnabled: true,
  automatedPayoutsEnabled: false,
  wipayFeeStructure: null,
  platformCommissionPercent: new Decimal(5),
};

// The pay settings are read on hot paths — every price shown in the
// marketplace uses the commission — so they're cached in memory and
// re-read every CACHE_MS (and at once after a change on this instance).
// Another instance picks a change up within CACHE_MS.
const CACHE_MS = 30_000;
let cached: { value: PaySettings; at: number } | null = null;

function toPaySettings(row: {
  paymentsEnabled: boolean;
  automatedPayoutsEnabled: boolean;
  wipayFeeStructure: string | null;
  platformCommissionPercent: Prisma.Decimal;
} | null): PaySettings {
  if (!row) return DEFAULT_PAY_SETTINGS;
  return {
    paymentsEnabled: row.paymentsEnabled,
    automatedPayoutsEnabled: row.automatedPayoutsEnabled,
    wipayFeeStructure: FEE_STRUCTURES.includes(row.wipayFeeStructure as FeeStructure) ? (row.wipayFeeStructure as FeeStructure) : null,
    platformCommissionPercent: new Decimal(row.platformCommissionPercent.toString()),
  };
}

/** Re-reads the pay settings into the cache. Called at start-up, after a change, and on a timer. */
export async function refreshPaySettings(db: PrismaClient | Prisma.TransactionClient = prisma): Promise<PaySettings> {
  const row = await db.platformSetting.findUnique({ where: { id: SETTINGS_ID } });
  cached = { value: toPaySettings(row), at: Date.now() };
  return cached.value;
}

/** The pay settings, from the cache when it's fresh. */
export async function getPaySettings(): Promise<PaySettings> {
  return cached && Date.now() - cached.at < CACHE_MS ? cached.value : refreshPaySettings();
}

/**
 * IsleVendor's commission as a fraction (0.05 for 5%), for pricing code
 * that can't wait on the database. Reads the cache — kept warm by
 * refreshPaySettings at start-up and on a timer (see startPaySettingsRefresh).
 */
export function platformCommissionRate(): Decimal {
  return (cached?.value ?? DEFAULT_PAY_SETTINGS).platformCommissionPercent.dividedBy(100);
}

/** Keeps the cache fresh in the background; returns a function that stops it. */
export function startPaySettingsRefresh(): () => void {
  const timer = setInterval(() => {
    refreshPaySettings().catch((err) => console.error('[settings] refresh failed', err));
  }, CACHE_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Who pays WiPay's card fee right now: the admin's choice, else the environment's. */
export async function effectiveFeeStructure(): Promise<FeeStructure> {
  return (await getPaySettings()).wipayFeeStructure ?? env.WIPAY_FEE_STRUCTURE;
}

/** Whether new card payments may start: the deployment allows them and no admin has paused them. */
export async function cardPaymentsEnabled(): Promise<boolean> {
  return env.ENABLE_WIPAY_WEBHOOKS && (await getPaySettings()).paymentsEnabled;
}

/** Whether payouts may be sent through WiPay: the deployment allows it and an admin has switched it on. */
export async function automatedPayoutsEnabled(): Promise<boolean> {
  return env.ENABLE_AUTOMATED_PAYOUTS && (await getPaySettings()).automatedPayoutsEnabled;
}

export async function updatePaySettings(
  changes: Partial<Omit<PaySettings, 'platformCommissionPercent'> & { platformCommissionPercent: number }>,
  updatedBy: string,
  db: PrismaClient | Prisma.TransactionClient = prisma,
) {
  const data = { ...changes, updatedBy };
  await db.platformSetting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
  return refreshPaySettings(db);
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
