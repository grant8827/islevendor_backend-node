import { Decimal } from 'decimal.js';

// Flat 5% of the warehouse's (post-discount) price on every item sold —
// AFFILIATE and STORE alike. See computeAffiliatePricing below for how an
// AFFILIATE order's other cut (the reseller's) is computed.
export const PLATFORM_COMMISSION_RATE = new Decimal('0.05');

/**
 * AFFILIATE pricing: the reseller's cut and the platform's cut are each a
 * percentage of the warehouse's own (post-discount) wholesale price, added
 * on top to form what the customer pays — the warehouse always receives
 * exactly its own listed (and possibly discounted) price in full. Because
 * every cut is computed off that same wholesale base, a warehouse discount
 * shrinks the reseller's and platform's take too, not just the warehouse's
 * own — this is used identically at listing-display time (commerce.routes.ts)
 * and at checkout time (orders.routes.ts) so the price a customer is shown
 * is always exactly the price they're charged.
 *
 * `resellerCommissionPercent` is set by the warehouse itself (see
 * Warehouse.resellerCommissionPercent) — not the reseller, and not a global
 * platform constant like PLATFORM_COMMISSION_RATE.
 */
export function computeAffiliatePricing({
  wholesalePriceJmd,
  discountPercent,
  resellerCommissionPercent,
  quantity = 1,
}: {
  wholesalePriceJmd: Decimal.Value;
  discountPercent: number;
  resellerCommissionPercent: number;
  quantity?: number;
}) {
  const discountMultiplier = new Decimal(1).minus(new Decimal(discountPercent).dividedBy(100));
  const unitWholesaleJmd = new Decimal(wholesalePriceJmd).times(discountMultiplier).toDecimalPlaces(2);
  const wholesaleTotalJmd = unitWholesaleJmd.times(quantity);
  const resellerMarginJmd = wholesaleTotalJmd.times(new Decimal(resellerCommissionPercent).dividedBy(100)).toDecimalPlaces(2);
  const platformCommissionJmd = wholesaleTotalJmd.times(PLATFORM_COMMISSION_RATE).toDecimalPlaces(2);
  const retailTotalJmd = wholesaleTotalJmd.plus(resellerMarginJmd).plus(platformCommissionJmd);

  return { unitWholesaleJmd, wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd, retailTotalJmd };
}
