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
//
// Weight: everything one seller sends in the delivery is weighed together
// (products with no weight count as 0). Each pound over includedWeight adds
// perPound to the fee, after the min/max. When perPound is set it replaces
// the extra-item charge, so a heavy order isn't charged twice. Heavier than
// maxWeight, IsleDash isn't offered.

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
  includedWeightLb: Decimal;
  perPoundJmd: Decimal;
  /** null: no limit. */
  maxWeightLb: Decimal | null;
}

export interface MapPin {
  latitude: number;
  longitude: number;
}

export type IsleDashQuote =
  /** distanceMiles null: no pin on one side, so charged the fallback fee. */
  | {
      available: true;
      rate: ShippingRate;
      distanceMiles: Decimal | null;
      missingPin: 'seller' | 'buyer' | null;
      weightLb: Decimal;
      /** What the weight added to the fee. */
      weightFeeJmd: Decimal;
    }
  | { available: false; rate: null; distanceMiles: Decimal | null; weightLb: Decimal; reason: string };

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

/** What `weightLb` pounds add to the fee. */
export function weightFee(pricing: IsleDashPricing, weightLb: Decimal): Decimal {
  const over = Decimal.max(weightLb.minus(pricing.includedWeightLb), 0);
  return over.times(pricing.perPoundJmd).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** Whether weight pricing is on — it then replaces the extra-item charge. */
export const chargesByWeight = (pricing: IsleDashPricing) => pricing.perPoundJmd.greaterThan(0);

const lb = (d: Decimal) => d.toDecimalPlaces(1).toString();

/**
 * What IsleDash costs from a seller pinned at `from` to a buyer at `to`, for
 * a delivery weighing `weightLb` in all, or why it isn't offered.
 */
export function isleDashQuote(pricing: IsleDashPricing, from: MapPin | null, to: MapPin | null, weightLb: Decimal = new Decimal(0)): IsleDashQuote {
  const miles = from && to ? deliveryMiles(pricing, from, to) : null;
  if (miles && pricing.maxMiles !== null && miles.greaterThan(pricing.maxMiles)) {
    return {
      available: false,
      rate: null,
      distanceMiles: miles,
      weightLb,
      reason: `IsleDash doesn't deliver this far (${miles.toFixed(1)} mi — the limit is ${lb(pricing.maxMiles)} mi)`,
    };
  }
  if (pricing.maxWeightLb !== null && weightLb.greaterThan(pricing.maxWeightLb)) {
    return {
      available: false,
      rate: null,
      distanceMiles: miles,
      weightLb,
      reason: `Too heavy for IsleDash (${lb(weightLb)} lb — the limit is ${lb(pricing.maxWeightLb)} lb)`,
    };
  }
  const base = miles ? distanceFee(pricing, miles) : pricing.fallbackFeeJmd;
  const extra = weightFee(pricing, weightLb);
  return {
    available: true,
    rate: { baseFeeJmd: base.plus(extra), extraItemPercent: chargesByWeight(pricing) ? 0 : pricing.extraItemPercent },
    distanceMiles: miles,
    missingPin: miles ? null : !from ? 'seller' : 'buyer',
    weightLb,
    weightFeeJmd: extra,
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
    includedWeightLb: Number(p.includedWeightLb),
    perPoundJmd: money(p.perPoundJmd),
    maxWeightLb: p.maxWeightLb === null ? null : Number(p.maxWeightLb),
  };
}
