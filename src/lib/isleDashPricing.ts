import { Decimal } from 'decimal.js';
import type { ShippingRate } from './deliveryOptions.js';

// IsleDash delivery is priced by distance, at rates an IsleVendor admin sets
// (Admin → Settings → Shipping; stored on PlatformSetting). The same rates
// apply to every seller that offers IsleDash.
//
//   miles = straight-line miles from the seller's map pin to the buyer's,
//           plus roadAdjustPercent (roads don't run straight)
//   fee   = baseFee + perMile × (miles − includedMiles, never below 0),
//           kept between minFee and maxFee, rounded to the dollar
//
// That fee is the first item's; each further item from the same seller in
// one checkout costs extraItemPercent of it (lib/deliveryOptions.ts). If
// either side has no map pin, the fee is fallbackFee. Further than maxMiles,
// IsleDash isn't offered at all.

export interface IsleDashPricing {
  baseFeeJmd: Decimal;
  includedMiles: Decimal;
  perMileJmd: Decimal;
  minFeeJmd: Decimal;
  /** null: no cap. */
  maxFeeJmd: Decimal | null;
  /** null: no limit. */
  maxMiles: Decimal | null;
  extraItemPercent: number;
  fallbackFeeJmd: Decimal;
  roadAdjustPercent: number;
}

export interface MapPin {
  latitude: number;
  longitude: number;
}

export type IsleDashQuote =
  /** distanceMiles null: no pin on one side, so charged the fallback fee. */
  | { available: true; rate: ShippingRate; distanceMiles: Decimal | null; missingPin: 'seller' | 'buyer' | null }
  | { available: false; rate: null; distanceMiles: Decimal; reason: string };

const EARTH_RADIUS_MILES = 3958.8;

/** Straight-line miles between two map pins. */
export function straightLineMiles(a: MapPin, b: MapPin): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** The miles a delivery is priced for — straight line plus the road adjustment — to one decimal place. */
export function deliveryMiles(pricing: Pick<IsleDashPricing, 'roadAdjustPercent'>, from: MapPin, to: MapPin): Decimal {
  return new Decimal(straightLineMiles(from, to)).times(100 + pricing.roadAdjustPercent).dividedBy(100).toDecimalPlaces(1);
}

/** The first item's fee for a delivery of `miles` (already road-adjusted). */
export function distanceFee(pricing: IsleDashPricing, miles: Decimal): Decimal {
  const charged = Decimal.max(miles.minus(pricing.includedMiles), 0);
  let fee = pricing.baseFeeJmd.plus(charged.times(pricing.perMileJmd));
  fee = Decimal.max(fee, pricing.minFeeJmd);
  if (pricing.maxFeeJmd !== null) fee = Decimal.min(fee, pricing.maxFeeJmd);
  return fee.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** What IsleDash costs from a seller pinned at `from` to a buyer at `to`, or why it isn't offered. */
export function isleDashQuote(pricing: IsleDashPricing, from: MapPin | null, to: MapPin | null): IsleDashQuote {
  if (!from || !to) {
    return {
      available: true,
      rate: { baseFeeJmd: pricing.fallbackFeeJmd, extraItemPercent: pricing.extraItemPercent },
      distanceMiles: null,
      missingPin: !from ? 'seller' : 'buyer',
    };
  }
  const miles = deliveryMiles(pricing, from, to);
  if (pricing.maxMiles !== null && miles.greaterThan(pricing.maxMiles)) {
    return {
      available: false,
      rate: null,
      distanceMiles: miles,
      reason: `IsleDash doesn't deliver this far (${miles.toFixed(1)} mi — the limit is ${pricing.maxMiles.toDecimalPlaces(1).toString()} mi)`,
    };
  }
  return {
    available: true,
    rate: { baseFeeJmd: distanceFee(pricing, miles), extraItemPercent: pricing.extraItemPercent },
    distanceMiles: miles,
    missingPin: null,
  };
}

/** A seller's map pin from its pin columns, or null if it hasn't placed one. */
export function sellerPin(seller: { pinLatitude: { toString(): string } | null; pinLongitude: { toString(): string } | null }): MapPin | null {
  if (seller.pinLatitude === null || seller.pinLongitude === null) return null;
  return { latitude: Number(seller.pinLatitude.toString()), longitude: Number(seller.pinLongitude.toString()) };
}

/** The pricing as JSON — what the admin console and sellers' Shipping tabs show. */
export function pricingToJson(p: IsleDashPricing) {
  const money = (d: Decimal) => d.toFixed(2);
  return {
    baseFeeJmd: money(p.baseFeeJmd),
    includedMiles: Number(p.includedMiles),
    perMileJmd: money(p.perMileJmd),
    minFeeJmd: money(p.minFeeJmd),
    maxFeeJmd: p.maxFeeJmd === null ? null : money(p.maxFeeJmd),
    maxMiles: p.maxMiles === null ? null : Number(p.maxMiles),
    extraItemPercent: p.extraItemPercent,
    fallbackFeeJmd: money(p.fallbackFeeJmd),
    roadAdjustPercent: p.roadAdjustPercent,
  };
}
