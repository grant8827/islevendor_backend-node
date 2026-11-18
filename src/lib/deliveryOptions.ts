import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { DeliveryMethod, Prisma } from '@prisma/client';
import { HttpError } from '../middleware/errorHandler.js';
import { isleDashQuote, sellerPin, type IsleDashPricing, type IsleDashQuote, type MapPin } from './isleDashPricing.js';

// How an order can reach the customer, and what each way costs. The
// business that packs the order (a shop, or the warehouse behind a reseller
// listing) decides which of these it offers; the customer picks one at
// checkout.
//  - ISLEDASH:        an IsleDash driver, at the platform's distance-based fee
//                     (lib/isleDashPricing.ts). The fee is held for the driver
//                     (see ledger.service.ts).
//  - SELLER_DELIVERY: the business's own delivery, at the fee it sets. The fee
//                     is the business's.
//  - PICKUP:          the customer collects it. Always free.

/**
 * What one way of delivering costs: the full fee for the first item, and
 * `extraItemPercent` of it for each further item bought from the same seller
 * in one checkout. Every unit counts — 3 of one product is three items.
 * IsleDash's rate is IsleVendor's, by distance (lib/isleDashPricing.ts); the seller's own
 * delivery rate is the seller's.
 */
export interface ShippingRate {
  baseFeeJmd: Decimal;
  extraItemPercent: number;
}

const FREE: ShippingRate = { baseFeeJmd: new Decimal(0), extraItemPercent: 0 };

export function extraItemFee(rate: ShippingRate): Decimal {
  return rate.baseFeeJmd.times(rate.extraItemPercent).dividedBy(100).toDecimalPlaces(2);
}

/** The fee for each of `units` items, in order: the first in full, the rest at the extra-item rate. Sums exactly to shippingTotal. */
export function perItemFees(rate: ShippingRate, units: number): Decimal[] {
  return Array.from({ length: units }, (_, i) => (i === 0 ? rate.baseFeeJmd : extraItemFee(rate)));
}

export function shippingTotal(rate: ShippingRate, units: number): Decimal {
  return units <= 0 ? new Decimal(0) : rate.baseFeeJmd.plus(extraItemFee(rate).times(units - 1));
}

/** The columns deliveryOptionsFor needs — select these wherever a warehouse or shop is loaded for checkout. */
export const DELIVERY_SETTINGS_SELECT = {
  addressLine: true,
  parish: true,
  offersIsleDash: true,
  offersSellerDelivery: true,
  sellerDeliveryFeeJmd: true,
  sellerDeliveryNote: true,
  sellerDeliveryExtraItemPercent: true,
  offersPickup: true,
  pickupInstructions: true,
  pinLatitude: true,
  pinLongitude: true,
} as const;

export interface DeliverySettings {
  addressLine: string;
  parish: string;
  /** A shop's separate pickup address, if it has one; otherwise its main address is where customers collect. */
  pickupAddress?: string | null;
  offersIsleDash: boolean;
  offersSellerDelivery: boolean;
  sellerDeliveryFeeJmd: Prisma.Decimal | null;
  sellerDeliveryNote: string | null;
  sellerDeliveryExtraItemPercent: number;
  offersPickup: boolean;
  pickupInstructions: string | null;
  /** The seller's map pin; null until placed (IsleDash then charges the fallback fee). */
  pinLatitude: Prisma.Decimal | null;
  pinLongitude: Prisma.Decimal | null;
}

export interface DeliveryOption {
  method: DeliveryMethod;
  label: string;
  /** The total for all `units` items being quoted. */
  feeJmd: string;
  firstItemFeeJmd: string;
  extraItemFeeJmd: string;
  /** What the customer should know about this option — where to collect, the business's delivery terms. */
  detail: string | null;
  /** Whether the customer has to give a delivery address. */
  needsAddress: boolean;
  /** IsleDash only: the road miles it was priced for; null when charged the fallback fee. */
  distanceMiles: string | null;
}

export function pickupLocationOf(seller: DeliverySettings): string {
  return `${seller.pickupAddress || seller.addressLine}, ${seller.parish}`;
}

/** What IsleDash costs from this seller to a buyer at `buyerPin`. */
export function isleDashQuoteFor(seller: DeliverySettings, pricing: IsleDashPricing, buyerPin: MapPin | null): IsleDashQuote {
  return isleDashQuote(pricing, sellerPin(seller), buyerPin);
}

/** The rate for `method` from this seller, or null if it doesn't offer it (or IsleDash can't reach the buyer). */
export function rateFor(seller: DeliverySettings, method: DeliveryMethod, isleDash: IsleDashQuote): ShippingRate | null {
  switch (method) {
    case 'ISLEDASH':
      return seller.offersIsleDash ? isleDash.rate : null;
    case 'SELLER_DELIVERY':
      return seller.offersSellerDelivery && seller.sellerDeliveryFeeJmd !== null
        ? { baseFeeJmd: new Decimal(seller.sellerDeliveryFeeJmd.toString()), extraItemPercent: seller.sellerDeliveryExtraItemPercent }
        : null;
    case 'PICKUP':
      return seller.offersPickup ? FREE : null;
  }
}

/** Throws 400 unless the seller offers `method` (and, for IsleDash, the buyer is in range). */
export function requireRate(seller: DeliverySettings, method: DeliveryMethod, isleDash: IsleDashQuote): ShippingRate {
  if (method === 'ISLEDASH' && seller.offersIsleDash && !isleDash.available) throw new HttpError(400, `${isleDash.reason} — choose another delivery option`);
  const rate = rateFor(seller, method, isleDash);
  if (!rate) throw new HttpError(400, "This seller doesn't offer that delivery option — choose another");
  return rate;
}

/** What the customer is told under the IsleDash option. */
function isleDashDetail(quote: IsleDashQuote): string | null {
  if (!quote.available) return null;
  if (quote.distanceMiles) return `${quote.distanceMiles.toFixed(1)} mi from the seller`;
  if (quote.missingPin === 'buyer') return 'Standard fee — add a map pin to your address to price it by distance';
  return 'Standard fee';
}

/** Every option this business currently offers for `units` items, in the order a customer should see them. */
export function deliveryOptionsFor(seller: DeliverySettings, isleDash: IsleDashQuote, units = 1): DeliveryOption[] {
  const describe = (method: DeliveryMethod, label: string, detail: string | null): DeliveryOption | null => {
    const rate = rateFor(seller, method, isleDash);
    if (!rate) return null;
    return {
      method,
      label,
      feeJmd: shippingTotal(rate, units).toFixed(2),
      firstItemFeeJmd: rate.baseFeeJmd.toFixed(2),
      extraItemFeeJmd: extraItemFee(rate).toFixed(2),
      detail,
      needsAddress: method !== 'PICKUP',
      distanceMiles: method === 'ISLEDASH' && isleDash.distanceMiles ? isleDash.distanceMiles.toFixed(1) : null,
    };
  };
  const where = pickupLocationOf(seller);
  return [
    describe('ISLEDASH', 'IsleDash delivery', isleDashDetail(isleDash)),
    describe('SELLER_DELIVERY', 'Delivered by the seller', seller.sellerDeliveryNote),
    describe('PICKUP', 'Pick up', seller.pickupInstructions ? `${where} — ${seller.pickupInstructions}` : where),
  ].filter((o): o is DeliveryOption => o !== null);
}

/** Why IsleDash isn't among this seller's options for this buyer, if it's only distance that rules it out. */
export function isleDashUnavailableReason(seller: DeliverySettings, isleDash: IsleDashQuote): string | null {
  return seller.offersIsleDash && !isleDash.available ? isleDash.reason : null;
}

/** What a business submits to change its delivery options. */
export const deliverySettingsSchema = z
  .object({
    offersIsleDash: z.boolean(),
    offersSellerDelivery: z.boolean(),
    sellerDeliveryFeeJmd: z.number().min(0).max(100_000).nullable().optional(),
    sellerDeliveryNote: z.string().trim().max(300).nullable().optional(),
    sellerDeliveryExtraItemPercent: z.number().int().min(0).max(100).default(50),
    offersPickup: z.boolean(),
    pickupInstructions: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => v.offersIsleDash || v.offersSellerDelivery || v.offersPickup, {
    message: 'Offer at least one way for customers to get their order',
  })
  .refine((v) => !v.offersSellerDelivery || (v.sellerDeliveryFeeJmd !== null && v.sellerDeliveryFeeJmd !== undefined), {
    message: 'Set a fee for your own delivery (it can be 0)',
    path: ['sellerDeliveryFeeJmd'],
  })
  .transform((v) => ({
    offersIsleDash: v.offersIsleDash,
    offersSellerDelivery: v.offersSellerDelivery,
    sellerDeliveryFeeJmd: v.offersSellerDelivery ? v.sellerDeliveryFeeJmd! : null,
    sellerDeliveryNote: v.sellerDeliveryNote || null,
    sellerDeliveryExtraItemPercent: v.sellerDeliveryExtraItemPercent,
    offersPickup: v.offersPickup,
    pickupInstructions: v.pickupInstructions || null,
  }));
